/**
 * 通过 CDP 驱动真实页面做一次冒烟测试（不需要 electron、不需要装任何依赖）。
 * 用法：
 *   1. chrome --headless=new --remote-debugging-port=9222 --remote-allow-origins=* <预览地址>
 *   2. node dev/cdp-check.mjs
 */
const PORT = process.env.CDP_PORT || 9222;

const listResp = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const targets = await listResp.json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('找不到页面目标');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const errors = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true
  });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + detail));
}

await send('Runtime.enable');
await send('Page.enable');

// 等应用启动完成
for (let i = 0; i < 40; i++) {
  const ready = await evalJS('!!(window.FB && window.FB.app && window.FB.app.state.data)');
  if (ready) break;
  await sleep(100);
}

const clockText = () => evalJS('document.getElementById("clock").textContent');
const timer = () => evalJS('JSON.parse(JSON.stringify(window.FB.app.state.data.timer))');
const sessionCount = () => evalJS('window.FB.app.state.data.sessions.length');

check('应用已启动并渲染出计时器', (await clockText()) === '25:00', await clockText());

// 1. 开始 → 倒计时
await evalJS('document.querySelector("[data-action=toggle-timer]").click()');
// 窗口不可见时 Chromium 会节流定时器，所以这里轮询等它刷新，而不是死等固定时长
let c1 = await clockText();
for (let i = 0; i < 25 && c1 === '25:00'; i++) {
  await sleep(200);
  c1 = await clockText();
}
const t1 = await timer();
check('点击开始后进入 running', t1.status === 'running', t1.status);
check('倒计时在走（< 25:00）', c1 !== '25:00', c1);

// 2. 暂停 → 时间冻结
await evalJS('document.querySelector("[data-action=toggle-timer]").click()');
const frozen = await clockText();
await sleep(900);
const frozen2 = await clockText();
check('暂停后状态为 paused', (await timer()).status === 'paused');
check('暂停后剩余时间冻结', frozen === frozen2, frozen + ' / ' + frozen2);

// 3. 重置
await evalJS('document.querySelector("[data-action=reset-timer]").click()');
const afterReset = await timer();
check('重置回到满时长', afterReset.status === 'idle' && afterReset.remainingSec === 1500, afterReset.remainingSec + 's');

// 4. 新增任务
const before = await evalJS('window.FB.app.state.data.tasks.length');
await evalJS(`
  (function () {
    const input = document.getElementById('new-task');
    input.value = 'CDP 冒烟任务';
    document.getElementById('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()
`);
await sleep(200);
const after = await evalJS('window.FB.app.state.data.tasks.length');
const newTitle = await evalJS('window.FB.app.state.data.tasks[window.FB.app.state.data.tasks.length-1].title');
check('新增任务成功', after === before + 1 && newTitle === 'CDP 冒烟任务', newTitle);

// 5. 勾选完成
await evalJS('document.querySelectorAll(".task-item .check")[0].click()');
check('任务可勾选完成', (await evalJS('window.FB.app.state.data.tasks[0].done')) === true);

// 6. 强制到期 → 结算成 session 并进入短休息（先把周期清零，保证是本轮第 1 个番茄）
const beforeSessions = await sessionCount();
await evalJS(`
  (function () {
    document.querySelector('[data-action=toggle-timer]').click();
    const d = window.FB.app.state.data;
    d.timer = Object.assign({}, d.timer, { cycle: 0, endsAt: Date.now() + 700, startedAt: Date.now() - 1500 * 1000 });
  })()
`);
await sleep(1500);
const afterSessions = await sessionCount();
const tAfter = await timer();
check('专注到期后写入一条 session', afterSessions === beforeSessions + 1, beforeSessions + ' → ' + afterSessions);
check('到期后自动进入短休息', tAfter.mode === 'short' && tAfter.status === 'idle', tAfter.mode + '/' + tAfter.status);
check('计时器显示休息时长', (await clockText()) === '05:00', await clockText());

// 7. 统计页
await evalJS('document.querySelector("[data-nav=stats]").click()');
await sleep(200);
const heatCells = await evalJS('document.querySelectorAll(".heat-cell").length');
const barCols = await evalJS('document.querySelectorAll(".bar-col").length');
check('统计页渲染 30 格热力图', heatCells === 30, heatCells);
check('统计页渲染 7 根柱', barCols === 7, barCols);
check('统计页显示今日专注', (await evalJS('document.querySelector(".stat-grid").textContent')).includes('今日专注'));

// 8. 设置页改时长并保存
await evalJS('document.querySelector("[data-nav=settings]").click()');
await sleep(200);
await evalJS(`
  (function () {
    document.getElementById('set-focus').value = '40';
    document.getElementById('settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()
`);
await sleep(200);
const settings = await evalJS('JSON.parse(JSON.stringify(window.FB.app.state.data.settings))');
check('设置保存生效', settings.focusMin === 40, 'focusMin=' + settings.focusMin);

await evalJS('document.querySelector("[data-nav=today]").click()');
await sleep(150);
await evalJS('document.querySelector("[data-mode=focus]").click()');
await sleep(150);
check('切换专注模式后应用新时长 40:00', (await clockText()) === '40:00', await clockText());

// 9. 深链接
await evalJS('location.hash = "#stats"');

check('无 JS 异常 / console.error', errors.length === 0, errors.join(' | ') || 'clean');

const failed = results.filter((r) => !r.ok);
console.log('\n通过 ' + (results.length - failed.length) + '/' + results.length);
ws.close();
process.exit(failed.length ? 1 : 0);
