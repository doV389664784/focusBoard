/**
 * 启动诊断：依次尝试不同的 Electron 启动参数，判断「渲染进程是否真的起来了」。
 *
 * 判断依据不是「进程还活着」（窗口没显示时进程也可能活着），而是
 * Chromium 的远程调试端口能不能列出一个标题为 FocusBoard 的页面——
 * 只有渲染进程初始化成功，才会出现这个页面。
 *
 * 用法：node dev\doctor.mjs
 * 结果同时写到 doctor-report.txt，方便贴给别人看。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error('找不到 ' + exe + '\n请先 npm install');
  process.exit(1);
}

const variants = [
  { key: '默认', args: [] },
  { key: '关闭 GPU 加速', args: ['--disable-gpu'], npm: 'start:gpu-off' },
  { key: '关闭 GPU 进程沙箱', args: ['--disable-gpu-sandbox'], npm: 'start:gpu-sandbox-off' },
  { key: '同时关 GPU 与 GPU 沙箱', args: ['--disable-gpu', '--disable-gpu-sandbox'], npm: 'start:gpu-off' },
  { key: '关闭 Chromium 沙箱', args: ['--no-sandbox'], npm: 'start:compat' }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    p.on('exit', resolve);
    p.on('error', resolve);
  });
}

async function isRendering(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const targets = await res.json();
    return targets.some((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
  } catch {
    return false;
  }
}

async function trial(variant, port) {
  // 必须真正删除这个变量：Electron 只看它存不存在，空字符串也算"以 Node 模式运行"
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(exe, ['.', '--remote-debugging-port=' + port, ...variant.args], {
    cwd: root,
    env,
    // 不用管道接输出：某些受限环境里 pipe 会失败，改用应用自己的 startup.log 判断
    stdio: 'ignore'
  });

  const logFile = path.join(root, '.userdata', 'startup.log');
  try {
    fs.unlinkSync(logFile);
  } catch { /* 首次运行没有这个文件 */ }

  let ok = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await isRendering(port)) {
      ok = true;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(400);
  }

  const exited = child.exitCode !== null;
  await killTree(child.pid);
  await sleep(500);

  // 从应用自己写的启动日志里取一条有用的信息
  let note = '';
  try {
    const log = fs.readFileSync(logFile, 'utf8');
    const lock = (log.match(/lock=(\w+)/) || [])[1];
    if (lock === 'failed') note = '单实例锁创建失败（数据目录不可写）';
    else if (lock === 'ok') note = '应用已启动，但窗口/页面没起来';
  } catch {
    note = '未生成 startup.log（崩在 Electron 初始化阶段）';
  }

  return { ok, exited, firstError: note };
}

const lines = [];
lines.push('FocusBoard 启动诊断');
lines.push('时间: ' + new Date().toISOString());
lines.push('Electron: ' + JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version);
lines.push('系统: ' + process.platform + ' ' + process.arch + ' / Node ' + process.version);
lines.push('');

let best = null;
let port = 9411;

for (const v of variants) {
  process.stdout.write('正在测试「' + v.key + '」... ');
  const r = await trial(v, port++);
  const verdict = r.ok ? '✅ 可以启动' : '❌ 渲染进程未启动';
  process.stdout.write(verdict + '\n');
  lines.push(
    (r.ok ? '[成功] ' : '[失败] ') + v.key +
    (v.npm ? '   → npm run ' + v.npm : '') +
    (r.firstError ? '   (' + r.firstError + ')' : '')
  );
  if (r.ok && !best) best = v;
}

lines.push('');
lines.push(best ? '建议使用的启动方式: ' + best.key + (best.npm ? '（npm run ' + best.npm + '）' : '（npm start 即可）') : '全部失败，需要更多信息');

fs.writeFileSync(path.join(root, 'doctor-report.txt'), lines.join('\n') + '\n', 'utf8');
console.log('\n' + lines.slice(-2).join('\n'));
console.log('\n报告已写入 doctor-report.txt');
