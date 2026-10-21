'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DATA_FILE = 'focusboard.json';
const ICON_DIR = path.join(__dirname, '..', 'build');

let win = null;
let tray = null;
let isQuitting = false;
let lastTrayText = '';

app.setAppUserModelId('com.example.focusboard');

/**
 * 数据目录。
 *
 * 踩过的坑：Chromium 启动时要在 userData 里创建 SingletonLock，某些环境
 * （受限的 %APPDATA%、企业策略、安全软件）会返回 ERROR_ACCESS_DENIED(5)，
 * 于是单实例锁拿不到、进程直接退出，用户看到的就是「点了没反应」。
 *
 * 策略：源码运行时把数据放在项目内的 .userdata（一定可写），
 * 打包后才用标准的 %APPDATA%\FocusBoard；都可用 FOCUSBOARD_DATA_DIR 覆盖。
 */
function resolveDataDir() {
  const override = process.env.FOCUSBOARD_DATA_DIR;
  if (override) return override;
  if (app.isPackaged) return path.join(app.getPath('appData'), 'FocusBoard');
  return path.join(__dirname, '..', '.userdata');
}

const DATA_DIR = resolveDataDir();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  app.setPath('userData', DATA_DIR);
} catch (err) {
  console.error('[focusboard] 数据目录不可用，沿用默认: ' + err.message);
}

/**
 * 写启动自检日志（每次启动覆盖写）。
 * 排查「点了没反应」时先看 .userdata/startup.log：
 *   文件不存在 → 崩在 Electron 初始化阶段，早于本文件执行；
 *   写入 lock=failed → 单实例锁失败（目录不可写 / 已有实例）。
 */
function writeStartupLog(extra) {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'startup.log'),
      [
        'time=' + new Date().toISOString(),
        'electron=' + process.versions.electron,
        'chrome=' + process.versions.chrome,
        'platform=' + process.platform + '/' + process.arch,
        'packaged=' + app.isPackaged,
        'dataDir=' + DATA_DIR
      ].concat(extra || []).join('\n') + '\n',
      'utf8'
    );
  } catch (err) {
    console.error('[focusboard] 写启动日志失败: ' + err.message);
  }
}

writeStartupLog(['lock=pending']);

// 单实例：第二次启动只唤起已有窗口。
let gotLock = false;
try {
  gotLock = app.requestSingleInstanceLock();
} catch (err) {
  console.error('[focusboard] 单实例锁异常: ' + err.message);
}

if (gotLock) {
  writeStartupLog(['lock=ok']);
  app.on('second-instance', function () {
    showWindow();
  });
  app.whenReady().then(onReady);
} else {
  writeStartupLog(['lock=failed']);
  console.error('[focusboard] 未能获取单实例锁：可能已有实例在运行，或数据目录不可写');
  app.quit();
}

function dataPath() {
  return path.join(app.getPath('userData'), DATA_FILE);
}

/**
 * 读取失败时把损坏文件改名备份，并返回 null 让渲染层用默认值。
 * 原则：宁可丢历史数据，也不能让应用起不来。
 */
function readData() {
  const file = dataPath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    try {
      const backup = file + '.corrupt-' + Date.now();
      fs.renameSync(file, backup);
      console.error('[focusboard] 数据文件损坏，已备份到 ' + backup, err);
    } catch (e) {
      console.error('[focusboard] 备份损坏文件失败', e);
    }
    return null;
  }
}

/** 临时文件 + rename：避免进程被强杀时留下半截 JSON */
function writeData(data) {
  const file = dataPath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[focusboard] 保存失败', err);
    return false;
  }
}

function trayImage() {
  const candidates = ['tray.png', 'tray-16.png'];
  for (let i = 0; i < candidates.length; i++) {
    const p = path.join(ICON_DIR, candidates[i]);
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return nativeImage.createEmpty();
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'FocusBoard',
    icon: path.join(ICON_DIR, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  win.once('ready-to-show', function () {
    win.show();
  });

  // 关闭 = 收进托盘（可在设置里关掉）。真正退出走托盘菜单 / app.quit()。
  win.on('close', function (e) {
    if (isQuitting) return;
    const data = readData();
    const minimizeToTray = !data || !data.settings || data.settings.minimizeToTray !== false;
    if (minimizeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', function () {
    win = null;
  });

  // 外链一律交给系统浏览器，禁止应用内导航
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (e, url) {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('FocusBoard · 就绪');
  tray.on('click', function () {
    if (win && win.isVisible()) win.hide();
    else showWindow();
  });
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    { type: 'separator' },
    {
      label: '退出 FocusBoard',
      click: function () {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function onReady() {
  createWindow();
  createTray();
}

app.on('window-all-closed', function () {
  // 有托盘时窗口关掉只是隐藏；托盘创建失败就正常退出，避免留下无窗口的后台进程
  if (process.platform === 'darwin') return;
  if (!tray) app.quit();
});

app.on('activate', function () {
  showWindow();
});

app.on('before-quit', function () {
  isQuitting = true;
});

// ---------------- IPC ----------------

ipcMain.handle('db:load', function () {
  return readData();
});

ipcMain.handle('db:save', function (_event, data) {
  return writeData(data);
});

ipcMain.handle('app:info', function () {
  return {
    version: app.getVersion(),
    platform: process.platform,
    dataDir: app.getPath('userData'),
    dataPath: dataPath()
  };
});

ipcMain.on('notify', function (_event, payload) {
  if (!payload) return;
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: String(payload.title || 'FocusBoard'),
      body: String(payload.body || ''),
      silent: false,
      icon: path.join(ICON_DIR, 'icon.png')
    }).show();
  } catch (err) {
    console.error('[focusboard] 通知失败', err);
  }
});

// 托盘提示随计时状态变化：专注中 · 12:30
ipcMain.on('tray:update', function (_event, text) {
  if (!tray) return;
  const t = String(text || '');
  if (t === lastTrayText) return;
  lastTrayText = t;
  tray.setToolTip(t || 'FocusBoard');
});
