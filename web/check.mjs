/**
 * ★ 一条命令跑完**全部判据**（0.19 新增，对应审查清单里的 C9）。
 *
 *     node web\check.mjs                 # 打包 + 四套 node 测试 + 三条 python 判据
 *     node web\check.mjs --no-build      # 不重新打包（只跑测试；ui.test.ts 用现有产物）
 *     node web\check.mjs --no-python     # 跳过 python 部分（没装 Python 的机器）
 *     node web\check.mjs --quiet         # 只打印每一段的最后一行
 *
 * 为什么要有它：在这之前，"全套判据"是 `web\README.md` 里**手打的八条命令**
 * （1 条打包 + core / card / image / ui 四套 node 测试 + 3 条 python 判据），
 * 没有任何脚本串起来 ⇒ 少跑一条、跑错目录、忘了先打包都只能靠人记得。这个文件只做三件事：
 * 按固定顺序跑、把每段的退出码收起来、最后给一张总表。
 * **它不写任何判据逻辑** —— 判据仍然在被调用的那些脚本里。
 * ⚠ 实际**执行**的命令是 9 条：上面那 8 条，加上"python 能不能用"这个探针
 *   （`python -c "print(1)"`，只用来决定后面 3 条跑不跑，本身不是判据）。
 *
 * ⚠ 子进程一律 `stdio: 'inherit'`：受限沙箱下 piped stdio 会 EPERM，
 *   而且 inherit 能让失败时的原始输出直接落在终端上（不丢信息）。
 *   `--quiet` 只对 node 那几条生效（改成 `stdio: 'ignore'`）；python 判据的**结果行**
 *   就是它唯一的输出（"N 项失败"），吞掉反而看不出跑到哪一步了，所以不静默。
 * ⚠ python 不存在时**跳过**（不算失败），因为抓取/解析那几条判据不是产品运行的前提；
 *   但会明确打印"跳过"，避免把"没跑"看成"跑过了"。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url)); // …\emblem-tool\web
const PROJ = dirname(WEB); // …\emblem-tool
const argv = process.argv.slice(2);

// ★ 不认识的参数要**报错**，不能静默忽略（照 `build.mjs::main()` 的做法）：
//   否则 `--no-buildd` 这种笔误会变成"跑一次完整构建"，而且看不出自己打错了。
const knownFlags = ['--no-build', '--no-python', '--quiet'];
const unknown = argv.filter((a) => a.startsWith('-') && !knownFlags.includes(a));
if (unknown.length) {
  console.error(`✗ 不认识的参数：${unknown.join(' ')}（只支持 ${knownFlags.join(' / ')}）`);
  process.exit(2);
}

const noBuild = argv.includes('--no-build');
const noPython = argv.includes('--no-python');
const quiet = argv.includes('--quiet');

const results = [];

/** 跑一条命令；返回退出码（命令不存在返回 'missing'）。 */
function run(label, cmd, args, cwd, opts = {}, skipCode = null) {
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
  let code = r.status ?? 1;
  // ★ 约定的"跳过码"：脚本用**退出码**表达"环境缺东西，跳过"，不算判据失败。
  if (skipCode !== null && code === skipCode) {
    console.log(`  ⏭ 退出码 ${code} ⇒ 这一步记成"跳过"（脚本自己的输出里写了原因）`);
    code = 'missing';
  }
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
//
//   ★ 三条判据各跑一次，**不重复**：
//     · `tools/acet_format.py` 的内部自检原来在 check.mjs 与 `tools/selftest.py:main()`
//       里各跑一次（同一份纯函数自检、同样的输出）⇒ 这里只留下面这一条；
//       `selftest.py` 里那一条由它自己的调用者负责（见 selftest.py 的注释）。
//     · "官方 exe 在哪"只有**一处真值**：`tools/selftest.py` 的 `--exe` 默认值。
//       check.mjs 不再自己拼 `dist/v1.0.2/acet.exe`（以前两处各写一份、必然漂移）；
//       找不到时由 selftest.py 打印原因并 **exit 2**，这里把 2 翻译成"跳过"。
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
  //   这一步是"与官方实现互相读写同一批样本"的交叉验证，缺了就**明确跳过并说明怎么补**
  //   （本地有 exe 时行为不变）。selftest.py 找不到 exe 时**返回 2** ⇒ 记成"跳过"。
  run('③ python：与官方 exe 交叉验证', py, [join(PROJ, 'tools', 'selftest.py')], PROJ, {}, 2);
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
