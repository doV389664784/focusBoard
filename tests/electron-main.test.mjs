/**
 * 主进程逻辑测试：用假的 electron 模块加载 electron/main.js，
 * 验证窗口/托盘/IPC/持久化这一层没有低级错误。
 * （此环境无法真正开 GUI 窗口，所以用桩替代）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-userdata-'));
// 让主进程把数据写到临时目录，避免污染项目里的 .userdata
process.env.FOCUSBOARD_DATA_DIR = userData;

const calls = {
  windows: [],
  trays: [],
  handlers: {},
  listeners: {},
  notifications: [],
  tooltips: [],
  opened: [],
  paths: {}
};

class FakeWebContents {
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  on() {}
}

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.events = {};
    this.webContents = new FakeWebContents();
    this.hidden = false;
    this.visible = true;
    calls.windows.push(this);
  }
  loadFile(p) { this.loaded = p; return Promise.resolve(); }
  once(name, fn) {
    this.events['once:' + name] = fn;
    // 立刻模拟 ready-to-show，让 show() 被调用
    if (name === 'ready-to-show') setImmediate(fn);
  }
  on(name, fn) { this.events[name] = fn; }
  isDestroyed() { return false; }
  isMinimized() { return false; }
  isVisible() { return this.visible; }
  restore() {}
  show() { this.visible = true; return Promise.resolve(); }
  hide() { this.visible = false; this.hidden = true; }
  focus() {}
}

class FakeTray {
  constructor(image) {
    this.image = image;
    this.menu = null;
    calls.trays.push(this);
  }
  setToolTip(t) { this.tooltip = t; calls.tooltips.push(t); }
  setContextMenu(m) { this.menu = m; }
  on() {}
}

const fakeElectron = {
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (name, fn) => { calls.listeners[name] = fn; },
    quit: () => { calls.quit = true; },
    setAppUserModelId: (id) => { calls.appId = id; },
    getVersion: () => '1.0.0',
    getPath: (name) => (name === 'userData' && calls.paths.userData ? calls.paths.userData : userData),
    setPath: (name, value) => { calls.paths[name] = value; }
  },
  BrowserWindow: FakeWindow,
  Tray: FakeTray,
  Menu: { buildFromTemplate: (tpl) => ({ template: tpl }) },
  ipcMain: {
    handle: (ch, fn) => { calls.handlers[ch] = fn; },
    on: (ch, fn) => { calls.handlers[ch] = fn; }
  },
  Notification: class {
    constructor(opts) { this.opts = opts; calls.notifications.push(opts); }
    show() {}
    static isSupported() { return true; }
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false }),
    createEmpty: () => ({ isEmpty: () => true })
  },
  shell: { openExternal: (u) => calls.opened.push(u) }
};

// 拦截 require('electron')
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

// 用 CJS 加载主进程，确保 __dirname 正确解析到 electron/
const require = Module.createRequire(path.join(root, 'electron', 'main.js'));
require(path.join(root, 'electron', 'main.js'));

const tick = () => new Promise((r) => setImmediate(r));

test('数据目录被显式指定（避免 %APPDATA% 锁文件问题）', () => {
  assert.equal(calls.paths.userData, userData);
  assert.ok(fs.existsSync(path.join(userData, 'startup.log')), '应写启动日志');
  assert.match(fs.readFileSync(path.join(userData, 'startup.log'), 'utf8'), /lock=ok/);
});

test('启动后创建窗口，并禁用 nodeIntegration', async () => {
  await tick();
  await tick();
  assert.equal(calls.windows.length, 1, '应创建 1 个窗口');
  const opts = calls.windows[0].options;
  assert.equal(opts.webPreferences.nodeIntegration, false);
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.sandbox, true);
  assert.match(opts.webPreferences.preload.replace(/\\/g, '/'), /electron\/preload\.js$/);
  assert.match(calls.windows[0].loaded.replace(/\\/g, '/'), /src\/index\.html$/);
});

test('托盘被创建，菜单含显示与退出', async () => {
  assert.equal(calls.trays.length, 1);
  const tpl = calls.trays[0].menu.template;
  const labels = tpl.map((i) => i.label).filter(Boolean);
  assert.ok(labels.includes('显示主窗口'), labels.join(','));
  assert.ok(labels.includes('退出 FocusBoard'), labels.join(','));
});

test('db:save 写入后 db:load 能读回（原子写）', async () => {
  const store = { version: 1, settings: { focusMin: 30 }, tasks: [], sessions: [] };
  const ok = await calls.handlers['db:save'](null, store);
  assert.equal(ok, true);

  const file = path.join(userData, 'focusboard.json');
  assert.ok(fs.existsSync(file), '应生成数据文件');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), store);

  const loaded = await calls.handlers['db:load']();
  assert.deepEqual(loaded, store);
  assert.ok(!fs.existsSync(file + '.tmp'), '临时文件应已被 rename 掉');
});

test('数据文件损坏时备份并返回 null，不让应用起不来', async () => {
  const file = path.join(userData, 'focusboard.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');

  const loaded = await calls.handlers['db:load']();
  assert.equal(loaded, null);

  const backups = fs.readdirSync(userData).filter((f) => f.includes('.corrupt-'));
  assert.equal(backups.length, 1, '应留下一个 .corrupt- 备份');
  assert.ok(!fs.existsSync(file), '坏文件应被移走');
});

test('通知与托盘文案走 IPC 不抛错', () => {
  assert.doesNotThrow(() => calls.handlers['notify'](null, { title: '专注完成', body: '休息 5 分钟' }));
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, '专注完成');

  calls.handlers['tray:update'](null, 'FocusBoard · 专注中 · 12:30');
  assert.equal(calls.trays[0].tooltip, 'FocusBoard · 专注中 · 12:30');

  // 相同文案不重复设置（去抖逻辑）
  const before = calls.tooltips.length;
  calls.handlers['tray:update'](null, 'FocusBoard · 专注中 · 12:30');
  assert.equal(calls.tooltips.length, before);
});

test('app:info 返回版本与数据路径', async () => {
  const info = await calls.handlers['app:info']();
  assert.equal(info.version, '1.0.0');
  assert.equal(info.dataPath, path.join(userData, 'focusboard.json'));
  assert.ok(info.platform.length > 0);
});

test('有托盘时关闭窗口不退出应用', async () => {
  const win = calls.windows[0];
  win.events.close({ preventDefault: () => { calls.prevented = true; } });
  assert.equal(calls.prevented, true, '应阻止默认关闭');
  assert.equal(win.hidden, true, '应隐藏到托盘');
  assert.notEqual(calls.quit, true);
});

test('清理临时目录', () => {
  fs.rmSync(userData, { recursive: true, force: true });
  assert.ok(!fs.existsSync(userData));
});
