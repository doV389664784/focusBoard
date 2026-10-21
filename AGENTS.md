# AGENTS.md

> 给 AI 编码助手（Codex / Copilot / Cursor / Claude）的项目说明。**改代码前先读这一页。**

## 这是什么项目

**FocusBoard**：纯本地的 Windows 桌面应用（Electron），三合一——今日任务看板 + 番茄专注计时 + 专注统计。
无后端、无账号、无网络请求。数据保存在 `%APPDATA%/FocusBoard/focusboard.json`。

需求边界见 [PRD.md](./PRD.md)，技术决策见 [TECH_DESIGN.md](./TECH_DESIGN.md)。**与本文件冲突时，以 PRD 的功能边界和技术设计的选型结论为准。**

## 怎么跑起来

```bash
npm install          # 首次；只装 electron（devDependency）
npm run start        # 开发运行（Electron 窗口）
npm run test         # 纯逻辑单元测试（node --test，不需要 electron）
```

仓库没有构建步骤：渲染层是原生 `<script>`，改完 `src/` 里的文件，重启 `npm run start` 即可。
调试渲染层可以**直接用浏览器打开 `src/index.html`**（会退化为 localStorage 存储），改样式时这样迭代最快。

## 硬性约定（不要违反）

### 1. 目录职责

| 路径 | 职责 | 禁止 |
| --- | --- | --- |
| `electron/main.js` | 窗口、托盘、通知、**唯一写盘者** | 不要在这里放业务逻辑 |
| `electron/preload.js` | 只暴露白名单 API | 不要暴露 `ipcRenderer` 本体或 `require` |
| `src/lib/timer.js` | 计时状态机，**纯函数** | 不要引入 DOM、`setInterval`、`Date.now()` 之外的副作用 |
| `src/lib/stats.js` | 统计聚合，**纯函数** | 不要读文件、不要依赖当前时钟（`now` 由调用方传入） |
| `src/app.js` | 渲染 + 事件 + 主循环 | 不要直接读写文件、不要 `require` |

### 2. 模块格式

`src/lib/*.js` 必须是 **UMD 风格双栖模块**（浏览器挂 `window.FB.xxx`，Node `module.exports`），因为单元测试直接 `require` 这些文件：

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.FB = root.FB || {}).xxx = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // ...
  return { /* API */ };
});
```

### 3. 时间只有一个真相来源

- 计时剩余时间**永远**用 `max(0, ceil((endsAt - now) / 1000))` 计算；
- **禁止**用 `seconds--` 或 `elapsed += 250` 这类累加式写法（休眠/节流必崩）；
- 所有 `now` 由调用方传入（毫秒时间戳），`lib/` 里不调用 `Date.now()`，这样才能在测试里冻结时间。

### 4. 数据写入

- 只允许通过 `db:save`（IPC）或 `localStorage` 落盘，主进程用「临时文件 + rename」原子替换；
- 每次变更后 `store.save()` 一次，**不要**为了「性能」攒批量（数据量小，简单可靠优先）；
- 读取到损坏数据时：备份为 `focusboard.json.corrupt-<ts>` 并回落默认值，**永远不要**让应用启动失败。

### 5. 样式

- 颜色、圆角、间距全部走 `src/styles.css` 顶部的 CSS 变量，不要硬编码色值；
- 新增视图请沿用 `.page-head` / `.card` / `.btn` 这几个既有类，保持视觉一致；
- 不引入任何 UI 组件库（Tailwind/Bootstrap/Ant）——项目刻意保持零构建。

### 6. 不做的事

- 不新增运行时依赖（`dependencies` 必须为空）；
- 不联网、不埋点、不上传数据；
- 不把 `nodeIntegration` 打开，不降低 `contextIsolation` / `sandbox`。

## 代码风格

- 原生 ES5/ES2017 语法（浏览器直接加载，不用转译）：`const`/`let`、箭头函数、模板字符串、`async/await` 都可以用；不用可选链之外的最新语法糖。
- 缩进 2 空格，单引号，语句结尾带分号。
- 函数优先、类只在确实需要状态封装时使用（目前没有）。
- 注释用中文，解释**为什么**而不是**做了什么**。

## 完成标准

改完之后至少满足：

1. `npm run test` 全绿；
2. `src/index.html` 在浏览器里打开无报错（看 Console）；
3. 新增/修改的功能，在 `PRD.md` 第 8 节验收清单里能找到对应条目。
